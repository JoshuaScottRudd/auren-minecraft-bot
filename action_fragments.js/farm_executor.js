// fragment: farm_executor (action / farming)
// purpose: Turns a plot into a working farm and tends it, owned end-to-end by the farming subsystem.
//          Reads STRUCTURE from blueprint_survey and FIELD state from farmland_site, then works one
//          pass per anchor: builds that spot's structure via anchored_repair, then
//          clears/tills/plants/harvests the cells it reaches.
//
// 'clear' frees a crop slot blocked by a non-air obstruction (a blueprint 'growing' voxel, external to
// the structural survey) via the shared performDig. Cells are worked from a stand beside the row, never
// by standing on the cell. Several anchors may partition a field wider than one stand's reach (Law 16).
//
// invariants: site must be locked before this runs (Law 13); every phase re-senses live state (Law 2);
// missing hoe/seeds warns and skips; every mutating verb re-senses before counting
// (Law 23); a pass that changed nothing and was refused reports success:false.

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
// Entered through combatCheckpoint, never battleStations directly — the process-wide 500ms gate shared
// with the dig/drive primitives (Law 16).
const { combatCheckpoint } = require('@api/battle_stations');
const blueprintSurvey = require('@perception/blueprint_survey');
const blueprintRegistry = require('@kernel/blueprint_registry');
const anchoredRepair = require('@api/anchored_repair');
const { getFarmlandCells, getFieldPlan } = require('@perception/farmland_site');
const { collectNearby } = require('@api/drop_collector.js');
const { FARM_BLUEPRINT_NAME } = require('@thinking/architect_config');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'farm_executor';
const PLACE_MAX_ATTEMPTS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Field-tend phases run in restricted passes with a collect between: harvest/clear drop items, so
// planting and (seed-gated) tilling wait until after those drops are collected (Invariant B).
const HARVEST_CLEAR = new Set(['harvest', 'clear']);
const TILL_ONLY     = new Set(['till']);
const PLANT_ONLY    = new Set(['plant']);

// Fill order for a structural voxel: group_to_item.structural_fill, the same lookup mining_executor
// uses (Law 16). Fences resolve from 'fence', dirt from 'dirt'. No stations on a farm.
const FILL_PREFERENCE = group_to_item.structural_fill;
const SOLID_FILL_TOKENS = new Set(['structural_fill']);

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

// Highest-tier owned hoe (group_to_item.hoe is lowest-first), so a worn hoe never blocks tilling once
// a better one exists.
function bestOwnedHoe(bot) {
  const owned = new Set(bot.inventory.items().map(i => i.name));
  const tiers = group_to_item.hoe;
  for (let i = tiers.length - 1; i >= 0; i--) if (owned.has(tiers[i])) return tiers[i];
  return null;
}

function countSeeds(bot) {
  return bot.inventory.items().filter(i => i.name === 'wheat_seeds').reduce((s, i) => s + i.count, 0);
}

// Whether `cell` is within BLOCK_REACH of `stand` — the one reach test shared by structural anchors,
// the field plan and bonemeal targeting (module-scoped so bonemealReachable can share it too).
function reaches(bot, stand, cell) {
  return anchoredRepair.reachFromStand(bot, stand, new Vec3(cell.x, cell.y, cell.z)) <= BLOCK_REACH;
}

// Budget of NEW cells this stand may hoe: one seed per cell, minus seed already spoken for by farmland
// standing empty (Invariant B). Called after the harvest collect, when the seed count is real.
function tillBudget(bot, reachablePlan) {
  const awaitingSeed = reachablePlan.filter(
    p => p.actions.includes('plant') && !p.actions.includes('till')).length;
  return Math.max(0, countSeeds(bot) - awaitingSeed);
}

// Runs one row cell's diff actions (clear/till/plant/harvest) from a reaching stand. Every action
// re-senses its own block (Law 2, Law 23) so an already-correct cell no-ops and a swing that changed
// nothing isn't counted. Missing hoe/seeds flags ctx and stops this cell (Law 13).
async function applyCell(bot, cell, ctx, allow) {
  const gpos = new Vec3(cell.x, cell.y, cell.z);
  const apos = gpos.offset(0, 1, 0);
  for (const action of cell.actions) {
    if (allow && !allow.has(action)) continue;   // phase filter: clear/harvest vs till vs plant
    // No whole-body guard: every branch re-senses its own outcome, so a catch here would only hide
    // which action ran without recording a verdict. The mineflayer calls are guarded individually below.
    {
      if (action === 'clear') {
        // Frees a blueprint 'growing' voxel holding something that isn't our wheat — never structure
        // or our own crop (Law 16).
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
        // Seed budget checked before the hoe swings, not in the plant branch. Deferring keeps 'till'
        // in the census for a later visit (Law 13).
        if (ctx.tillBudget <= 0) { ctx.tillDeferred++; ctx.missingSeeds = true; continue; }
        const item = bot.inventory.items().find(i => i.name === hoe);
        if (!item) { ctx.missingHoe = true; return; }
        await guardExternal(TAG, `equip/lookAt/till at (${cell.x},${cell.y},${cell.z})`, async () => {
          await bot.equip(item, 'hand');
          await bot.lookAt(gpos.offset(0.5, 1, 0.5));
          await bot.activateBlock(g);
        });
        await sleep(100);
        // The guard's result is not read: a refused packet and an accepted-then-reverted one look the
        // same here, so the block re-sense below is what verifies.
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
        await require('@kernel/item_book').during('sow', 'planted', async () => {
          await guardExternal(TAG, `equip/lookAt/sow at (${cell.x},${cell.y},${cell.z})`, async () => {
            await bot.equip(seeds, 'hand');
            await bot.lookAt(gpos.offset(0.5, 1, 0.5));
            await bot.activateBlock(g);
          });
          await sleep(100);
        });
        // Confirms OUR crop is standing there, not merely that the slot stopped being air.
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
  // Only a solid block obstructs a placement; air needs no digging and a fluid is not tool-breakable
  // (performDig refuses it) — the place pass displaces a fluid directly.
  if (!block || isAir(block.name) || isFluid(block.name)) return true;
  return performDig(bot, pos, block, TAG);
}

async function placeOne(bot, step, ev) {
  const pos = ev.pos;
  const itemName = resolveItemName(bot, step.type);
  if (!itemName) return false;

  if (ev.underFeet) {
    // Footing under the feet is scaffolding, not structure — spent from the throwaway pillar order,
    // not the structural fill (Law 16).
    const res = await pillarStep(bot, {
      candidateItemNames: group_to_item[normalizeBlockName(step.type)] || group_to_item.pillar_block });
    if (!res.success) watcher.warn(TAG, `pillarStep (footing) failed at (${pos.x},${pos.y},${pos.z}): ${res.reason}`);
    return res.success;
  }

  const current = bot.blockAt(pos);
  // Pre-dig only when the cell holds a solid block that isn't already the target block; placeBlock
  // replaces a fluid directly, and performDig would only refuse it.
  if (current && !isAir(current.name) && !isFluid(current.name)) {
    if (current.name === itemName) return 'already';
    if (!await performDig(bot, pos, current, TAG)) return false;
  }

  // Equip/aim/click/re-sense live in the shared place route (Law 16); `ok` is the whole verdict here.
  const placed = await performPlace(bot, pos, ev.anchor, ev.face, itemName, TAG);
  if (placed.ok) return true;
  watcher.warn(TAG, `Place failed at (${pos.x},${pos.y},${pos.z}) — ${placed.reason}`);
  return false;
}

// Walk to a stand and settle microCentered + armed. False means the field is cut off; the caller
// abandons to the judge (Law 13).
async function reachStand(bot, anchor) {
  const stand = { x: anchor.x, y: anchor.y + 1, z: anchor.z };   // feet cell on top of the anchor block
  // Skip goTo when the feet already occupy the stand — re-issuing it reads as an identical-goal stall
  // to the judge and kills the farm loop (Invariant B).
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

// ── STRUCTURAL: build one anchor's fence/floor voxels from its stand via the shared primitive. The
// blueprint declares its water/crop cells external, so the survey never touches them — every step here
// is structure only (Invariant D).
async function buildAnchor(bot, stand, steps, anchorLabel) {
  if (steps.length === 0) return { dig_ok: 0, place_ok: 0, place_fail: 0, deferred: 0 };
  const ops = {
    digOne: (s) => digOne(bot, s),
    placeOne: (s, ev) => placeOne(bot, s, ev),
    resolveItem: (type) => resolveItemName(bot, type),
    isOptional: () => false,          // a farm has no optional decorations
    tag: TAG,
    maxPlaceAttempts: PLACE_MAX_ATTEMPTS,
    footingSidestep: true,   // never dig the block the bot is standing on (shared opt-in, Law 16)
  };
  return anchoredRepair.repairAtAnchor(bot, { stand, steps, label: anchorLabel }, ops);
}

// tendPlot(bot, roomKey, blueprintName) → services ONE plot: builds its structure, then till/plant/
// harvest the cells it reaches, and returns the outcome. Law 15 sub-loop API — farm_manager calls this
// directly and owns the routing to recursive_judge; a per-plot failure returns worked=0 with a reason.
//
// ── BONE MEAL ── applied where the bot is already standing over its own crops, no separate trip. A
// plant at or past BONE_MEAL_MAX_CROP_STAGE is skipped (already due for harvest); one that did not
// advance after use is not retried (activateBlock cannot fail loudly — Law 25). Reads the crop census,
// not getFieldPlan: that plan carries only corrective actions, so a healthy crop is absent from it.
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
    await require('@kernel/item_book').during('bone_meal', 'planted', async () => {
      await bot.equip(item, 'hand');
      await bot.activateBlock(bot.blockAt(cropPos));
    });
    const after = getWheatAge(bot.blockAt(cropPos));
    if (after != null && after > age) ctx.bonemealed = (ctx.bonemealed || 0) + 1;
  }
}

async function tendPlot(bot, roomKey, blueprintName) {
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before tendPlot ran.`);
    }
    // Geometry is read from this instance's lock, never named from config, so it can't go stale against
    // what set_buildspot actually stamped (Law 25). roomKey defaults to instance 0 for a single-farm caller.
    roomKey = roomKey || FARM_BLUEPRINT_NAME;
    blueprintName = blueprintName || blueprintSurvey.geometryOf(roomKey);

    // The field's anchors (stand = anchor floor Y+1); a blueprint may declare several when the field
    // exceeds one stand's reach. getWorldAnchors throws if the site isn't locked (Law 13).
    const worldAnchors = blueprintSurvey.getWorldAnchors(blueprintName, roomKey);
    // Resolve each anchor to a standable stand — its own feet if intact, else a dry lip within reach
    // (Law 16). null ⇒ nothing standable reaches this plot; guarded here too (Law 13).
    const fallback = blueprintRegistry.getBuilding(blueprintName, TAG).stand_fallback !== false;
    const resolved = worldAnchors.map(a => anchoredRepair.resolveStandableAnchor(bot, a, { fallback }));
    if (resolved.every(r => r === null)) {
      watcher.warn(TAG, `all ${worldAnchors.length} anchor(s) stranded — no standable stand reaches the plot (dynamic water?); non-actionable this pass.`);
      return { worked: 0, refused: 0, reason: 'stranded', metrics: {} };
    }
    const resolvedFloor = resolved.map((r, i) => r ? { ...r.floor } : { x: worldAnchors[i].x, y: worldAnchors[i].y, z: worldAnchors[i].z });
    const stands = resolved.map((r, i) => r ? r.feet : ({ x: worldAnchors[i].x, y: worldAnchors[i].y + 1, z: worldAnchors[i].z }));
    const usingAlt = resolved.some(r => r && r.alternate);
    if (usingAlt) watcher.summary(TAG, `stand relocated: ${resolved.filter(r => r && r.alternate).length}/${worldAnchors.length} anchor(s) tended from a dry lip (primary stand water-damaged).`);

    // Survey the structure once, group its dig/place steps by anchor; crop/water cells are external so
    // these steps are pure structure. Unguarded — the survey is ours (Law 13, Law 25).
    const structure = await blueprintSurvey.survey(bot, blueprintName, roomKey);
    const allSteps = Array.isArray(structure?.steps) ? structure.steps : [];
    const anchorSteps = worldAnchors.map(() => []);
    for (const s of allSteps) {
      const ai = s.anchor_index ?? -1;
      if (ai >= 0 && ai < worldAnchors.length) anchorSteps[ai].push(s);
    }

    const { rowCells } = getFarmlandCells(bot, roomKey);
    const uncovered = rowCells.filter(c => !stands.some(s => reaches(bot, s, c)));
    if (uncovered.length > 0) watcher.warn(TAG, `${uncovered.length} row cell(s) reachable from no anchor — blueprint coverage gap, not worked this pass`);

    // ── ONE PASS PER SPOT: at each anchor, build its structure then till/plant/harvest the cells it
    // reaches. The field plan is re-sensed after building (Invariant B), so dirt laid this pass is
    // planted the same visit. ──
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

      // (1) STRUCTURE at this spot. Abandon to the judge on an unreachable anchor (Law 13).
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

      // (2) FIELD at this spot — harvest/clear → collect → till → plant → collect → plant, each an
      // ordered restricted pass (Invariant B). The closing collect+replant catches seed drops that
      // scattered out of range on the first collect; the guard below also checks bonemealTargets since
      // a bonemeal-only visit has an empty corrective plan.
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
      // Re-armed per stand from the live seed count against what's already waiting to be sown.
      ctx.tillBudget = tillBudget(bot, getFieldPlan(bot, roomKey).filter(p => reaches(bot, stand, p)));
      await applyReachable(TILL_ONLY);        // hoe at most as much dirt as there is seed to fill
      await applyReachable(PLANT_ONLY);       // sow it the same visit — dig, place, till, plant, in order
      await collectHere();                    // one more drop collect — catch a missed/scattered seed
      await applyReachable(PLANT_ONLY);       // one last replant attempt, then move on
      await bonemealReachable(bot, stand, roomKey, ctx);   // speed what is already in the ground
    }

    const refused = ctx.clearRefused + ctx.tillRefused + ctx.plantRefused;
    // bonemealed counts as work — the visit's only product on a bonemeal-phase plot; omitting it would
    // report worked=0 for a successful application (Law 25).
    const worked  = (struct.place_ok || 0) + (struct.dig_ok || 0)
                  + ctx.cleared + ctx.tilled + ctx.planted + ctx.harvested + ctx.drops
                  + (ctx.bonemealed || 0);

    const metrics = {
      struct_place: struct.place_ok || 0, struct_dig: struct.dig_ok || 0,
      cleared: ctx.cleared, tilled: ctx.tilled, planted: ctx.planted,
      harvested: ctx.harvested, drops: ctx.drops, refused, till_deferred: ctx.tillDeferred,
      bonemealed: ctx.bonemealed || 0,
    };
    // The row's key leads so the farm lens can credit the visit to the row it worked (one row per tendPlot).
    const readable = `${TAG}: ${roomKey} struct(place=${metrics.struct_place},dig=${metrics.struct_dig}) cleared=${ctx.cleared} tilled=${ctx.tilled} planted=${ctx.planted} harvested=${ctx.harvested} drops=${ctx.drops}${ctx.bonemealed ? ` bonemealed=${ctx.bonemealed}` : ''}`
      + (ctx.missingHoe ? ' [no hoe]' : '') + (ctx.missingSeeds ? ' [no seeds]' : '')
      + (ctx.clearRefused ? ` [clear refused x${ctx.clearRefused}]` : '')
      + (ctx.tillRefused  ? ` [till refused x${ctx.tillRefused}]`   : '')
      // A deferral is not a refusal — the bot declined to hoe ground it can't sow — but must stay
      // visible so the judge can see a seed-starved field spinning (Law 6, Law 25).
      + (ctx.tillDeferred ? ` [till deferred x${ctx.tillDeferred} — no seed to sow it]` : '')
      + (ctx.plantRefused ? ` [plant refused x${ctx.plantRefused}]` : '');
    watcher.summary(TAG, readable);

    // Returns to the manager (Law 16): worked>0 is progress; worked===0 && refused>0 is a stuck plot,
    // never counted as success. Missing hoe/seeds stays actionable to re-post (Law 13).
    return { worked, refused, metrics, missingHoe: ctx.missingHoe, missingSeeds: ctx.missingSeeds,
             reason: (worked === 0 && refused > 0) ? 'field_refused' : 'farm_pass' };
}

module.exports = { tendPlot };
