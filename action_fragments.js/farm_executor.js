// fragment: farm_executor (action / farming)
// purpose: The engine of the farming triad — transforms a plot into a working farm and tends it, all
//          owned end-to-end by the farming subsystem (no hand-off to the building system).
//          It reads the STRUCTURE from the neutral blueprint_survey (fence/floor/dirt diff) and the
//          FIELD from farmland_site (clear/till/plant/harvest census), then works ONE PASS PER SPOT: at
//          each anchor it builds that spot's missing structure via the shared anchored_repair primitive
//          (the same reuse mining_executor makes), then clears/tills/plants/harvests the cells it
//          reaches — a single visit. Structure precedes field only LOCALLY (farmland must exist before a
//          seed goes in); there is no separate whole-field building sequence. Harvest is per-cell on
//          mature wheat, so a ripe cell and an empty one are both handled the same pass.
//
// WHY 'clear' is a field verb. The crop slot above each row cell is a blueprint 'growing' voxel, and
// 'growing' is declared external — so the structural survey never digs it. Nothing owned an obstruction
// sitting there, and Minecraft refuses to hoe dirt under a non-air block, so the cell deadlocked forever.
// The field owns the transitions a dig/place diff cannot express, and "the slot is stoppered" is one of
// them — so it is cleared here, with the shared performDig, not by widening the builder.
//
// WHY reach cells from beside the row (not walk cell-to-cell): standing ON a cell to till/plant
// it — the old verbs' approach — meant the bot occupied the very space a seed must go into
// (placeBlock into the bot's own AABB times out). Reaching from beside the row is the physically
// correct move.
// WHY per anchor (not one stand): a 9-wide field exceeds the 4.5 reach radius, so the blueprint
// declares MULTIPLE anchors to partition it — every voxel is within reach of its OWN anchor's
// stand, none within reach of a single shared stand. The executor stands at EACH anchor in turn
// (structural voxels AND farm cells), exactly as build_executor does (Law 16 reuse). A single-stand
// build reaches only the nearest anchor's half and throws a Law 13 reach violation on the far
// anchor's voxels the moment a farm site locks.
//
// invariants:
//  - farmland_site + set_buildspot must have locked the site (perception throws otherwise —
//    Law 13 coding violation: a farm job dispatched before the site is located is a planning bug).
//  - Self-contained (Law 2): every phase re-senses live world state; no phase assumes a sibling's.
//  - No hoe / no seeds is environmental (land_prep resupplies, or a durability loss) — warn and
//    skip that phase, never throw. The tend loop re-posts while the field stays actionable.
//  - Every world-mutating verb RE-SENSES before it counts. activateBlock cannot fail loudly, so an
//    unverified counter is a lie waiting to happen: a count taken from intent instead of a re-sensed
//    outcome can report success on a swing that changed nothing, with zero warnings raised. Count
//    outcomes, never intent (Law 23).
//  - A pass that changed nothing AND was refused reports success:false. Five fabricated successes are
//    indistinguishable to recursive_judge from a healthy fragment looping, so it kills the bot instead
//    of surfacing the stuck field. Best-effort must never mean best-pretend.

'use strict';

const Vec3 = require('vec3');
const watcher = require('@kernel/watcher');
const locomotion = require('@locomotion/locomotion_dispatcher');

const { group_to_item, normalizeBlockName, isWheatMature, getWheatAge, BLOCK_REACH } = require('@utils/fragment_utils');
const { BONE_MEAL_MAX_CROP_STAGE } = require('@thinking/architect_config');
const { performDig } = require('@utils/movement/dig_authority');
const { performPlace } = require('@utils/movement/place_authority');
const { microCenter } = require('@utils/movement/motion_primitives');
const { pillarStep } = require('@utils/movement/scaffold_movement');
const { isAir } = require('@utils/movement/terrain_predicates');
const { isFluid } = require('@utils/gravity_utils');   // water/lava set — the same one performDig refuses on (Law 16)
// Entered through combatCheckpoint, never battleStations directly. One process-wide 500 ms clock,
// shared with the dig and drive primitives that carry the same gate, plus the engaging/escaping bypass
// so combat's own arms cannot re-enter it. The whole reasoning is in its header; a call a primitive
// already paid for costs nothing here.
const { combatCheckpoint } = require('@api/battle_stations');
const blueprintSurvey = require('@perception/blueprint_survey');
const anchoredRepair = require('@api/anchored_repair');
const { getFarmlandCells, getFieldPlan } = require('@perception/farmland_site');
const { collectNearby } = require('@api/drop_collector.js');
const { FARM_BLUEPRINT_NAME } = require('@thinking/architect_config');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'farm_executor';
const STEP_WAIT_MS = 200;
const PLACE_MAX_ATTEMPTS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Field-tend phases: harvesting and clearing DROP items on the ground, so planting must wait until
// AFTER those drops are collected — otherwise a cell is re-sown before its own seed has been picked
// up. applyCell therefore runs in restricted passes with a collect between, never one combined pass.
// 'clear' joins the first pass for the same reason harvest is there: freeing a crop slot drops the
// block that was stoppering it.
//
// WHY 'till' is OUT of the drops-first pass: tilling produces no drop, so it was only in that pass to
// precede 'plant'. Running it there means the hoe swings BEFORE the harvest's seeds have been picked
// up, so the seed count cannot gate it. Every till a seedless bot performs CREATES work it cannot do,
// so the plot gets further from done the longer it is worked. Tilling last, after the collect, is what
// makes the count real enough to budget against (Invariant B — gate on sensed seeds, not on the seeds
// held before the harvest).
const HARVEST_CLEAR = new Set(['harvest', 'clear']);
const TILL_ONLY     = new Set(['till']);
const PLANT_ONLY    = new Set(['plant']);

// Fill order for a structural 'structural_fill' voxel (floor gap) — the CANONICAL one, not a local
// opinion about it. This was a hand-written literal, and it was the fleet's SECOND answer to "what may
// fill a structural voxel": mining_executor asks group_to_item for the same token and got a different
// order back, so the same blueprint token resolved differently depending on which executor reached it
// (Law 16). It also led with dirt, which is right for throwaway scaffolding and wrong for permanent
// floor — the structural order spends the most durable block first for exactly the opposite reason the
// scaffold order spends the cheapest.
// Fences resolve from the 'fence' group; dirt from the 'dirt' group. No stations on a farm.
const FILL_PREFERENCE = group_to_item.structural_fill;
const SOLID_FILL_TOKENS = new Set(['structural_fill']);
const EMPTY_STATION_SET = new Set();

// Resolve a blueprint token to an owned item name. Group tokens (fence/dirt) pick the first
// owned member; structural_fill walks the fill preference; a concrete token matches by name.
function resolveItemName(bot, token) {
  const items = bot.inventory?.items?.() || [];
  const has = name => items.some(i => i.name === name && i.count > 0);
  const t = normalizeBlockName(token);
  if (SOLID_FILL_TOKENS.has(t)) return FILL_PREFERENCE.find(has) || null;
  if (group_to_item[t]) return group_to_item[t].find(has) || null;
  return has(t) ? t : null;
}

// Highest-tier owned hoe (group_to_item.hoe is lowest-first). Mirrors the old till_farmland's
// bestOwnedHoe so a worn wooden hoe never blocks tilling once a better one exists.
function bestOwnedHoe(bot) {
  const owned = new Set(bot.inventory.items().map(i => i.name));
  const tiers = group_to_item.hoe;
  for (let i = tiers.length - 1; i >= 0; i--) if (owned.has(tiers[i])) return tiers[i];
  return null;
}

function countSeeds(bot) {
  return bot.inventory.items().filter(i => i.name === 'wheat_seeds').reduce((s, i) => s + i.count, 0);
}

// How many NEW cells this stand may hoe: one seed per cell, minus the seed already spoken for by
// farmland that is standing empty right now. Counted from the live plan, not from the till list —
// a cell classified ['plant'] with no 'till' IS bare farmland waiting, and hoeing more dirt while
// those wait just spreads the same seed thinner over more unplanted ground.
//
// Called AFTER the harvest collect, never before: on an established plot the harvest is what
// produces the seed the planting uses, so a count taken earlier reads zero on a field that is about
// to be self-sufficient and would freeze it (the wrong turn here is a bare "no seeds → skip till",
// which deadlocks a mature farm). Harvest and clear are never gated for the same reason — they are
// the seed source. Returns a whole-number budget; 0 means hoe nothing this visit.
// WHY module scope rather than a closure inside tendPlot: bonemealReachable is a sibling function
// called from tendPlot's own loop and needs the same helper, so a closure scoped to tendPlot would
// leave it out of reach for that caller. A file-level definition cannot be out of scope for anything
// in the file.
function reaches(bot, stand, cell) {
  return anchoredRepair.reachFromStand(bot, stand, new Vec3(cell.x, cell.y, cell.z)) <= BLOCK_REACH;
}

function tillBudget(bot, reachablePlan) {
  const awaitingSeed = reachablePlan.filter(
    p => p.actions.includes('plant') && !p.actions.includes('till')).length;
  return Math.max(0, countSeeds(bot) - awaitingSeed);
}

// applyCell — run one row cell's diff actions (clear/till/plant/harvest) from a reaching stand.
// Every action re-senses its own block (Law 2) so the precomputed plan stays honest as the cell
// mutates mid-chain (stone→air→dirt→farmland→wheat) and an already-correct cell no-ops instead of
// double-working. Till and plant are use-item-on-block (activateBlock, like the hoe): placeBlock
// waits on a blockUpdate crop placement doesn't fire. Missing hoe/seeds is environmental — flag it
// on ctx and stop this cell; the loop resupplies next sweep (Law 13).
//
// WHY every action RE-SENSES BEFORE IT COUNTS: activateBlock cannot fail loudly — mineflayer sends
// the packet, the server silently drops it when the move is illegal, nothing throws. A counter
// incremented immediately after that call would report success on a hoe swing that changed nothing,
// with zero warnings raised. performDig (the harvest path, in this same function) already returns a
// verified boolean; till and plant must match that discipline rather than count intent instead of
// outcome. An attempt is not an outcome (Law 23).
async function applyCell(bot, cell, ctx, allow) {
  const gpos = new Vec3(cell.x, cell.y, cell.z);
  const apos = gpos.offset(0, 1, 0);
  for (const action of cell.actions) {
    if (allow && !allow.has(action)) continue;   // phase filter — clear/harvest/till vs plant (see DROPS_FIRST)
    // NO WHOLE-BODY GUARD. Every branch already takes its verdict by RE-SENSING the cell after acting
    // (is it farmland now, is our crop standing there), so the only thing the catch added was a path
    // where the action ran and the verification did not — the census then counted neither a success nor
    // a refusal for a cell that was touched. The mineflayer calls are guarded individually below.
    {
      if (action === 'clear') {
        // Free an obstructed crop slot. farmland_site only ever emits this for a blueprint-declared
        // 'growing' voxel holding something that is not our wheat, so this cannot dig structure or
        // a crop; performDig is the shared, already-verified digger (Law 16 — not a second one).
        const above = bot.blockAt(apos);
        if (!above || isAir(above.name)) continue;               // someone/something already cleared it
        if (above.name === 'wheat') continue;                    // never dig our own crop, whatever its age reads
        if (!await performDig(bot, apos, above, TAG)) { ctx.clearRefused++; continue; }
        ctx.cleared++;
        await sleep(100);
      } else if (action === 'till') {
        const hoe = bestOwnedHoe(bot);
        if (!hoe) { ctx.missingHoe = true; return; }
        const g = bot.blockAt(gpos);
        if (!g || !group_to_item.dirt.includes(g.name) || g.name === 'farmland') continue;
        // Seed budget (see tillBudget). Checked HERE, not in the plant branch below, because by the
        // time that branch runs the hoe has already swung — which is the whole defect. Deferring is
        // not a failure: the cell keeps its 'till' in the census and is hoed on a visit that can
        // also sow it (Law 13 — validate the precondition before acting, not after).
        if (ctx.tillBudget <= 0) { ctx.tillDeferred++; ctx.missingSeeds = true; continue; }
        const item = bot.inventory.items().find(i => i.name === hoe);
        if (!item) { ctx.missingHoe = true; return; }
        await guardExternal(TAG, `equip/lookAt/till at (${cell.x},${cell.y},${cell.z})`, async () => {
          await bot.equip(item, 'hand');
          await bot.lookAt(gpos.offset(0.5, 1, 0.5));
          await bot.activateBlock(g);
        });
        await sleep(100);
        // The guard's result is deliberately not read: a refused packet and an accepted-then-reverted
        // one are the same event to this census, and only the world can tell them apart.
        if (bot.blockAt(gpos)?.name !== 'farmland') { ctx.tillRefused++; continue; }   // verify or don't count
        ctx.tilled++;
        ctx.tillBudget--;   // spend the seed this farmland is now waiting for (a refusal spends nothing)
      } else if (action === 'plant') {
        if (countSeeds(bot) === 0) { ctx.missingSeeds = true; return; }
        const g = bot.blockAt(gpos);
        const above = bot.blockAt(apos);
        if (!g || g.name !== 'farmland' || (above && above.name !== 'air')) continue;
        const seeds = bot.inventory.items().find(i => i.name === 'wheat_seeds');
        if (!seeds) { ctx.missingSeeds = true; return; }
        await guardExternal(TAG, `equip/lookAt/sow at (${cell.x},${cell.y},${cell.z})`, async () => {
          await bot.equip(seeds, 'hand');
          await bot.lookAt(gpos.offset(0.5, 1, 0.5));
          await bot.activateBlock(g);
        });
        await sleep(100);
        // getWheatAge is name-checked at source, so this confirms OUR crop is standing there —
        // not merely that the slot stopped being air.
        if (getWheatAge(bot.blockAt(apos)) === null) { ctx.plantRefused++; continue; }
        ctx.planted++;
      } else if (action === 'harvest') {
        const above = bot.blockAt(gpos.offset(0, 1, 0));
        if (!above || above.name !== 'wheat' || !isWheatMature(above)) continue;
        if (!await performDig(bot, above.position, above, TAG)) continue;   // unaccepted break — don't count a harvest that never happened
        ctx.harvested++;
        await sleep(100);
      }
    }
  }
}

// ── Structural per-block mechanics injected into the shared primitive (farm domain) ──
async function digOne(bot, step) {
  const pos = new Vec3(step.place.x, step.place.y, step.place.z);
  const block = bot.blockAt(pos);
  // Only SOLID blocks obstruct a placement, so only those are worth digging. Air needs no
  // removal; a fluid (water/lava) is not tool-breakable — performDig refuses it, and bot.dig
  // never resolves on a fluid (no air blockUpdate, rides the full 30s clamp). The place-all pass
  // that follows displaces the fluid by placing INTO it (fluids are replaceable), so digging it
  // first is both impossible and wasted — a non-solid cell is already "clear" for placement.
  if (!block || isAir(block.name) || isFluid(block.name)) return true;
  return performDig(bot, pos, block, TAG);
}

async function placeOne(bot, step, ev) {
  const pos = ev.pos;
  const itemName = resolveItemName(bot, step.type);
  if (!itemName) return false;

  if (ev.underFeet) {
    // The blueprint's own block first (this footing IS part of the structure), then the THROWAWAY order —
    // not the structural one. Reaching a footing is locomotion; what it stands on is scaffolding the farm
    // does not keep, so it spends trash rather than fill (Law 16: the pillar has one order, and this is a
    // pillar).
    const res = await pillarStep(bot, {
      candidateItemNames: group_to_item[normalizeBlockName(step.type)] || group_to_item.pillar_block });
    if (!res.success) watcher.warn(TAG, `pillarStep (footing) failed at (${pos.x},${pos.y},${pos.z}): ${res.reason}`);
    return res.success;
  }

  const current = bot.blockAt(pos);
  // Clear only a SOLID obstruction before placing. A fluid in the target cell is NOT dug — bot
  // placeBlock replaces water/lava directly (both are replaceable), and performDig would only
  // refuse it and fail the whole place. Air likewise needs no clearing. So we pre-dig a cell
  // solely when it holds a solid block that is not already the block we want.
  if (current && !isAir(current.name) && !isFluid(current.name)) {
    if (current.name === itemName) return 'already';
    if (!await performDig(bot, pos, current, TAG)) return false;
  }

  // Equip, gate, aim, click and re-sense all live in the one place route (Law 16). What stays here is
  // the farm's own criterion: any non-air block in the cell is a placed crop/farmland, so `ok` is the
  // whole answer and no extra test is needed on `after`.
  const placed = await performPlace(bot, pos, ev.anchor, ev.face, itemName, TAG);
  if (placed.ok) return true;
  watcher.warn(TAG, `Place failed at (${pos.x},${pos.y},${pos.z}) — ${placed.reason}`);
  return false;
}

// Walk to a stand and settle microCentered + armed. Returns false when the field is cut off so
// the caller abandons to the judge (Law 13 environmental — an unreachable field is a world
// condition, not a bug). goTo owns its own movement retries (Law 15) and returns arrived=false
// only after exhausting them.
async function reachStand(bot, anchor) {
  // The stand is the feet cell ON TOP of the anchor block (goToStand owns that +1). We keep the feet
  // cell here only to re-sense whether we already occupy it.
  const stand = { x: anchor.x, y: anchor.y + 1, z: anchor.z };
  // Already ON the anchor cell → skip the goTo. A farm's anchors sit a cell or two apart, so after
  // building anchor i the bot is usually already standing on anchor i+1's cell. Re-issuing goTo to a
  // cell the feet already occupy makes locomotion "arrive" at the same coordinate on visit after
  // visit, which the portable judge reads as an identical-goal stall and STRICT-kills the whole farm
  // signal. Re-sense the feet against the target and move only on a real gap (Invariant B) —
  // locomotion is asked to move only when there is a move to make.
  const feet = bot.entity.position.floored();
  if (feet.x === stand.x && feet.y === stand.y && feet.z === stand.z) {
    await microCenter(bot);
    await combatCheckpoint(bot, 'farm');
    return true;
  }
  const nav = await locomotion.goToStand(anchor);
  if (!nav || nav.arrived === false) return false;
  await microCenter(bot);
  await combatCheckpoint(bot, 'farm');
  return true;
}

// ── STRUCTURAL: build ONE anchor's fence/floor voxels from its stand via the shared primitive.
// Steps arrive pre-grouped by anchor_index. The blueprint declares its river ('water') and crop
// ('growing') cells as external voxels, so the survey skips them entirely — never placed, never dug —
// and every step here is pure fence/floor/dirt structure. The crop cell's contents are the field
// phase's business, not the structural pass's (Invariant D).
async function buildAnchor(bot, stand, steps, anchorLabel) {
  if (steps.length === 0) return { dig_ok: 0, place_ok: 0, place_fail: 0, deferred: 0 };
  const ops = {
    digOne: (s) => digOne(bot, s),
    placeOne: (s, ev) => placeOne(bot, s, ev),
    resolveItem: (type) => resolveItemName(bot, type),
    isOptional: () => false,          // a farm has no optional decorations
    stationTypes: EMPTY_STATION_SET,  // no stations on a farm
    tag: TAG,
    maxPlaceAttempts: PLACE_MAX_ATTEMPTS,
    // Never dig the block being stood on. The step-aside machinery already exists in anchored_repair
    // and building already opts in; without this, any step landing on the plot's own stand cell would
    // run in the bulk pass and mine the floor out from under the bot. This is the opt-in, not a second
    // implementation (Law 16). Paired with the wheat_plot_pair anchor being an external voxel, which
    // removes the cause; this is the safety net if any future step ever targets the footing again.
    footingSidestep: true,
  };
  return anchoredRepair.repairAtAnchor(bot, { stand, steps, label: anchorLabel }, ops);
}

// tendPlot(bot, roomKey, blueprintName) → service ONE plot: build its structure, then till/plant/harvest
// the cells it reaches, and RETURN the outcome. Law 15 sub-loop API — farm_manager calls this directly in
// its cluster loop and OWNS the routing to recursive_judge; this API writes nothing to a payload and routes
// no signal of its own. The old signal `receive` is retired (Law 16: one caller, one pathway — the manager
// is the sole invoker now). A per-plot failure (unreachable / all-refused) returns worked=0 with a reason;
// the manager skips that plot and services the rest, escalating only if the WHOLE visit worked nothing.
// ── BONE MEAL ── the payoff end of the composter chain, applied where the bot is ALREADY standing over its own crops —
// no separate job, no second trip. That placement is the whole economy of it: bone meal is scarce (~23
// compostables per unit) and walking to spend it would cost more than the growth stage it buys.
//
// TWO REFUSALS, both arithmetic rather than policy:
//   - a plant at or past BONE_MEAL_MAX_CROP_STAGE is skipped. Mature wheat is stage 7 and is about to be
//     harvested anyway, so feeding it converts a scarce item into nothing at all.
//   - a plant that did not advance is not retried. Bone meal on wheat advances several stages when it
//     lands, so a re-sense showing no change means the packet was dropped rather than that more is needed
//     — activateBlock cannot fail loudly (the same trap the hoe note above records), which is precisely
//     why this reads the age back instead of counting what it sent (Law 25).
// ── WHY THIS READS THE CELL CENSUS AND NOT getFieldPlan ──────────────────────────────────────────
// getFieldPlan carries only cells needing a CORRECTIVE action — clear, till, plant, harvest. A healthy
// mid-growth crop needs none of those, so it yields no actions and is absent from that plan entirely.
// Walking the plan to find bone-meal targets therefore searches the one set that can never contain one,
// and the failure is silent in both directions: no target found, nothing attempted, nothing refused.
// The crop census is the set this question is actually about (Law 16 — same primitive both the plan and
// the state census are built from, asked the way this caller needs it).
function bonemealTargets(bot, stand, roomKey) {
  const { rowCells } = getFarmlandCells(bot, roomKey);
  return rowCells.filter((c) => {
    if (!reaches(bot, stand, c)) return false;
    const age = getWheatAge(bot.blockAt(new Vec3(c.x, c.y + 1, c.z)));
    return age != null && age <= BONE_MEAL_MAX_CROP_STAGE;
  });
}

async function bonemealReachable(bot, stand, roomKey, ctx) {
  const held = () => bot.inventory.items().find(i => i && i.name === 'bone_meal');
  if (!held()) return;
  for (const cell of bonemealTargets(bot, stand, roomKey)) {
    const item = held();
    if (!item) return;
    const cropPos = new Vec3(cell.x, cell.y + 1, cell.z);
    const age = getWheatAge(bot.blockAt(cropPos));
    if (age == null || age > BONE_MEAL_MAX_CROP_STAGE) continue;
    await bot.equip(item, 'hand');
    await bot.activateBlock(bot.blockAt(cropPos));
    const after = getWheatAge(bot.blockAt(cropPos));
    if (after != null && after > age) ctx.bonemealed = (ctx.bonemealed || 0) + 1;
  }
}

async function tendPlot(bot, roomKey, blueprintName) {
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before tendPlot ran.`);
    }
    // WHICH geometry — READ from this instance's chair, never named from config. The two are the same
    // string today (every plot is a `wheat_plot_pair`), and that is exactly why the constant was the wrong
    // way to get it: it states what the geometry OUGHT to be instead of what set_buildspot stamped, so it
    // goes stale silently the first time an instance is locked under anything else (Law 25). The room key
    // still defaults to instance 0 for a single-farm caller, which is a different question (which plot).
    roomKey = roomKey || FARM_BLUEPRINT_NAME;
    blueprintName = blueprintName || blueprintSurvey.geometryOf(roomKey);

    // The field's anchors, one stand each (anchor floor Y + 1). A blueprint may declare MULTIPLE anchors
    // when its field exceeds one stand's reach; wheat_plot_pair has ONE, its
    // structural_fill stand. getWorldAnchors throws if the site isn't locked — a farm job before
    // set_buildspot is a planning bug (Law 13). Geometry comes from the neutral survey engine, not
    // building_integrity: the farm is owned end-to-end by the farming subsystem.
    const worldAnchors = blueprintSurvey.getWorldAnchors(blueprintName, roomKey);
    // Resolve each anchor to a STANDABLE stand: the anchor's own feet if its floor is intact, else a dry
    // lip within reach — a plot whose stand block was lost to dynamic water still needs a stable block
    // within the placement radius to build from. null ⇒ nothing standable reaches this plot;
    // farming_integrity already marks such a plot non-actionable so the manager never
    // dispatches here, but guard anyway (Law 13, default-stopped) rather than drive the body into water.
    // resolvedFloor[] is what reachStand/goToStand drives the feet ONTO; stands[] (the feet cells) feeds
    // the reach math and repairAtAnchor. Same resolveStandableAnchor the integrity gate uses (Law 16).
    const resolved = worldAnchors.map(a => anchoredRepair.resolveStandableAnchor(bot, a));
    if (resolved.every(r => r === null)) {
      watcher.warn(TAG, `all ${worldAnchors.length} anchor(s) stranded — no standable stand reaches the plot (dynamic water?); non-actionable this pass.`);
      return { worked: 0, refused: 0, reason: 'stranded', metrics: {} };
    }
    const resolvedFloor = resolved.map((r, i) => r ? { ...r.floor } : { x: worldAnchors[i].x, y: worldAnchors[i].y, z: worldAnchors[i].z });
    const stands = resolved.map((r, i) => r ? r.feet : ({ x: worldAnchors[i].x, y: worldAnchors[i].y + 1, z: worldAnchors[i].z }));
    const usingAlt = resolved.some(r => r && r.alternate);
    if (usingAlt) watcher.summary(TAG, `stand relocated: ${resolved.filter(r => r && r.alternate).length}/${worldAnchors.length} anchor(s) tended from a dry lip (primary stand water-damaged).`);

    // Survey the structure once, group its dig/place steps by anchor. The survey skips the blueprint's
    // declared crop/water cells (external voxels), so these steps are pure structure (for a
    // wheat_plot_pair plot: a single structural_fill + dirt).
    // Unguarded: the survey is ours. `scan_failed` with zero worked and zero refused is indistinguishable
    // downstream from a farm that needed no structural work, so a broken surveyor read as a finished farm
    // (Law 13; Law 25 — a default is not a measurement).
    const structure = blueprintSurvey.survey(bot, blueprintName, roomKey);
    const allSteps = Array.isArray(structure?.steps) ? structure.steps : [];
    const anchorSteps = worldAnchors.map(() => []);
    for (const s of allSteps) {
      const ai = s.anchor_index ?? -1;
      if (ai >= 0 && ai < worldAnchors.length) anchorSteps[ai].push(s);
    }

    const { rowCells } = getFarmlandCells(bot, roomKey);
    const uncovered = rowCells.filter(c => !stands.some(s => reaches(bot, s, c)));
    if (uncovered.length > 0) watcher.warn(TAG, `${uncovered.length} row cell(s) reachable from no anchor — blueprint coverage gap, not worked this pass`);

    // ── ONE PASS PER SPOT: at each anchor, build its structure, THEN till/plant/harvest the cells it
    // reaches — one visit, one owner. Structure precedes field LOCALLY at each spot (farmland must
    // exist before a seed goes in), but there is no separate whole-field build stage handed off to a
    // later planting pass — the farm is worked as a single farming operation.
    // The field plan is re-sensed AFTER building (Invariant B) so a cell whose dirt this pass just laid
    // is planted the same visit; applyCell re-senses per action so a cell reachable from two stands is
    // worked at the first and no-ops at the second. ──
    const struct = { dig_ok: 0, place_ok: 0, place_fail: 0, deferred: 0 };
    const ctx = { cleared: 0, tilled: 0, planted: 0, harvested: 0, drops: 0,
                  clearRefused: 0, tillRefused: 0, plantRefused: 0, tillDeferred: 0,
                  tillBudget: 0,   // re-armed per stand from live seed count (see tillBudget)
                  missingHoe: false, missingSeeds: false };
    for (let i = 0; i < stands.length; i++) {
      const stand = stands[i];
      const steps = anchorSteps[i];
      const ownsCells = rowCells.some(c => reaches(bot, stand, c));
      if (steps.length === 0 && !ownsCells) continue;   // nothing here — no walk

      // (1) STRUCTURE at this spot. A farm we cannot stand at is unreachable; abandoning to the judge
      // (rather than reporting a false success) lets recursive_judge count contiguous failures and kill
      // the loop if the field stays cut off (Law 13 environmental).
      if (steps.length > 0) {
        if (!await reachStand(bot, resolvedFloor[i])) {
          const readable = `${TAG}: fail anchor ${i} unreachable (${stand.x},${stand.y},${stand.z})`;
          watcher.warn(TAG, readable);
          return { worked: 0, refused: 0, reason: 'anchor_unreachable', metrics: {} };
        }
        const r = await buildAnchor(bot, stand, steps, `farm anchor ${i}`);
        struct.dig_ok += r.dig_ok || 0; struct.place_ok += r.place_ok || 0;
        struct.place_fail += r.place_fail || 0; struct.deferred += r.deferred || 0;
      }

      // (2) FIELD at this spot — harvest → collect → replant, then a closing collect → replant.
      // Ordered restricted passes (each re-senses getFieldPlan, Invariant B) so the physical order is
      // honored: cut ripe wheat and till fresh dirt FIRST — both drop items (wheat + seeds) at the bot's
      // feet — THEN collect those drops, THEN re-sow the now-empty farmland with the seeds just picked
      // up. The closing collect+replant is a SECOND replant attempt: wheat always drops ≥1 seed so an
      // empty cell can always be re-sown, but a drop can scatter out of pickup
      // range for a tick, so a single collect can miss it — the extra pass catches the straggler. A
      // first-time plot (nothing ripe) harvests/collects nothing and just plants from held seeds — same
      // path. Collection is INLINE here (bot standing over the seeds), not a single trailing sweep that
      // would only reach the last anchor's drops.
      // A BONEMEAL-ONLY VISIT HAS AN EMPTY CORRECTIVE PLAN, so this guard alone skipped every stand and
      // the bone-meal application below was unreachable — the phase that dispatches the visit could never
      // be served by it. The guard asks "is there work at this stand", and bone meal is work.
      if (!getFieldPlan(bot, roomKey).some(p => reaches(bot, stand, p))
          && bonemealTargets(bot, stand, roomKey).length === 0) continue;
      if (!await reachStand(bot, resolvedFloor[i])) {
        const readable = `${TAG}: fail anchor ${i} unreachable (${stand.x},${stand.y},${stand.z})`;
        watcher.warn(TAG, readable);
        return { worked: 0, refused: 0, reason: 'anchor_unreachable', metrics: {} };
      }
      const applyReachable = async (allow) => {
        for (const cell of getFieldPlan(bot, roomKey).filter(p => reaches(bot, stand, p))) {
          await combatCheckpoint(bot, 'farm');
          await applyCell(bot, cell, ctx, allow);
        }
      };
      const collectHere = async () => { ctx.drops += (await collectNearby(bot)).picked_up || 0; };

      await applyReachable(HARVEST_CLEAR);   // free stoppered slots + harvest ripe — the seed source
      await collectHere();                   // collect drops; the seed count is only real after this
      // Arm the budget from what is actually in the pocket NOW, against what is already waiting to be
      // sown. One re-arm per stand: the plan is re-sensed per pass, but the seeds are one pool.
      ctx.tillBudget = tillBudget(bot, getFieldPlan(bot, roomKey).filter(p => reaches(bot, stand, p)));
      await applyReachable(TILL_ONLY);        // hoe at most as much dirt as there is seed to fill
      await applyReachable(PLANT_ONLY);       // sow it the same visit — dig, place, till, plant, in order
      await collectHere();                    // one more drop collect — catch a missed/scattered seed
      await applyReachable(PLANT_ONLY);       // one last replant attempt, then move on
      await bonemealReachable(bot, stand, roomKey, ctx);   // speed what is already in the ground
    }

    const refused = ctx.clearRefused + ctx.tillRefused + ctx.plantRefused;
    // bonemealed counts as WORK. It is the visit's only product on a bonemeal-phase plot, so leaving it
    // out reports a successful application as worked=0 — an outcome signal contradicting what happened,
    // which the judge reads as a stuck loop and kills (Law 25).
    const worked  = (struct.place_ok || 0) + (struct.dig_ok || 0)
                  + ctx.cleared + ctx.tilled + ctx.planted + ctx.harvested + ctx.drops
                  + (ctx.bonemealed || 0);

    const metrics = {
      struct_place: struct.place_ok || 0, struct_dig: struct.dig_ok || 0,
      cleared: ctx.cleared, tilled: ctx.tilled, planted: ctx.planted,
      harvested: ctx.harvested, drops: ctx.drops, refused, till_deferred: ctx.tillDeferred,
      bonemealed: ctx.bonemealed || 0,
    };
    const readable = `${TAG}: struct(place=${metrics.struct_place},dig=${metrics.struct_dig}) cleared=${ctx.cleared} tilled=${ctx.tilled} planted=${ctx.planted} harvested=${ctx.harvested} drops=${ctx.drops}${ctx.bonemealed ? ` bonemealed=${ctx.bonemealed}` : ''}`
      + (ctx.missingHoe ? ' [no hoe]' : '') + (ctx.missingSeeds ? ' [no seeds]' : '')
      + (ctx.clearRefused ? ` [clear refused x${ctx.clearRefused}]` : '')
      + (ctx.tillRefused  ? ` [till refused x${ctx.tillRefused}]`   : '')
      // A deferral is NOT a refusal — the world said nothing, the bot declined to make farmland it
      // could not sow. It still has to be visible: an invisible skip reads as a plot with no work,
      // and the count is what tells the judge a seed-starved field is spinning (Law 6, Law 25).
      + (ctx.tillDeferred ? ` [till deferred x${ctx.tillDeferred} — no seed to sow it]` : '')
      + (ctx.plantRefused ? ` [plant refused x${ctx.plantRefused}]` : '');
    watcher.summary(TAG, readable);

    // The verdict travels back to the MANAGER (this is an API now, not a signal fragment): worked>0 is real
    // progress; worked===0 && refused>0 means the world refused every action — a stuck plot the manager must
    // NOT count as success. Fabricated successes read to recursive_judge as a healthy fragment looping
    // rather than a stuck field, so the anti-fabrication rule lives one level up, in the manager's
    // per-visit tally. Missing hoe/seeds leave the plot actionable to re-post — best-effort,
    // never a throw (Law 13 environmental). A no-op pass (nothing ripe) is worked===0, refused===0: benign.
    return { worked, refused, metrics, missingHoe: ctx.missingHoe, missingSeeds: ctx.missingSeeds,
             reason: (worked === 0 && refused > 0) ? 'field_refused' : 'farm_pass' };
}

// tillBudget's export was for a bench that no longer exists (see `tools/README.md`). The function
// itself stays — tendPlot calls it internally (line ~467) to arm ctx.tillBudget — but nothing outside
// this file ever reached it through the export, so only the export is trimmed here (Law 16). The claim
// it carries — "never hoe more ground than there is seed to sow", i.e. the budget can never go negative —
// is owed as a load-time throw here. Until that is written the guarantee does not exist anywhere.
module.exports = { tendPlot };
