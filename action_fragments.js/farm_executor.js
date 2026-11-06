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
const { isFluid, isGravityBlock } = require('@utils/gravity_utils');   // water/lava set — the same one performDig refuses on (Law 16)
// Entered through combatCheckpoint, never battleStations directly — the gate shared with the dig/drive
// primitives, asked on every call (Law 16).
const { combatCheckpoint } = require('@api/battle_stations');
const blueprintSurvey = require('@perception/blueprint_survey');
const blueprintRegistry = require('@kernel/blueprint_registry');
const anchoredRepair = require('@api/anchored_repair');
const { getFarmlandCells, getFieldPlan } = require('@perception/farmland_site');
const { collectNearby } = require('@api/drop_collector.js');
const { WATER } = require('@perception/farming_integrity');
const { guardExternal } = require('@utils/external_library_guard');

const TAG = 'farm_executor';
const PLACE_MAX_ATTEMPTS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// One server tick and a little: the crop's new age reaches the client before the next use reads it.
const BONE_MEAL_SETTLE_MS = 150;

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
  if (t === WATER) return has('water_bucket') ? 'water_bucket' : null;   // a water cell is poured, never placed
  if (SOLID_FILL_TOKENS.has(t)) return FILL_PREFERENCE.find(has) || null;
  // A natural floor (under a field's water) is laid from any natural block held, never one that falls.
  if (t === 'natural_block') return group_to_item.natural_block.find(n => has(n) && !isGravityBlock(n)) || null;
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

function countSeeds(bot, seed = 'wheat_seeds') {
  return bot.inventory.items().filter(i => i.name === seed).reduce((s, i) => s + i.count, 0);
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
  if (cell.crop && !cell.crop.tilled) return applyPlantedCell(bot, cell, ctx, allow, gpos, apos);
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

const WET_SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// A crop planted on the ground as it lies (sugar cane, farmland_site CROPS): 'clear' digs what stoppers the slot,
// 'plant' sets the crop's item on the ground's top face, 'harvest' breaks the second block up (everything above it
// comes down with it) and leaves the bottom one to grow again; under THE LAST CUT (farmland_site) it breaks the bottom
// block, so the whole stalk comes down. Each re-senses its block before it counts.
async function applyPlantedCell(bot, cell, ctx, allow, gpos, apos) {
  const crop = cell.crop;
  for (const action of cell.actions) {
    if (allow && !allow.has(action)) continue;
    if (action === 'clear') {
      const above = bot.blockAt(apos);
      if (!above || isAir(above.name) || above.name === crop.block) continue;
      if (!await performDig(bot, apos, above, TAG)) { ctx.clearRefused++; continue; }
      ctx.cleared++;
      await sleep(100);
    } else if (action === 'plant') {
      const held = bot.inventory.items().find(i => i.name === crop.seed);
      if (!held) { ctx.missingSeeds = true; return; }
      const g = bot.blockAt(gpos);
      const above = bot.blockAt(apos);
      if (!g || (above && !isAir(above.name))) continue;
      // Sugar cane takes only on a block with water beside it: a cell whose channel is not poured yet waits for the
      // pour, and no plant is tried there.
      if (!WET_SIDES.some(([dx, dz]) => bot.blockAt(gpos.offset(dx, 0, dz))?.name === WATER)) { ctx.awaitingWater++; continue; }
      await require('@kernel/item_book').during('sow', 'planted', async () => {
        await guardExternal(TAG, `equip/lookAt/plant ${crop.seed} at (${cell.x},${cell.y},${cell.z})`, async () => {
          await bot.equip(held, 'hand');
          await bot.lookAt(gpos.offset(0.5, 1, 0.5));
          await bot.activateBlock(g);
        });
        await sleep(100);
      });
      if (bot.blockAt(apos)?.name !== crop.block) { ctx.plantRefused++; continue; }
      ctx.planted++;
    } else if (action === 'harvest') {
      const cut = bot.blockAt(crop.last_cut ? apos : apos.offset(0, 1, 0));
      if (!cut || cut.name !== crop.block) continue;
      if (!await performDig(bot, cut.position, cut, TAG)) continue;
      ctx.harvested++;
      await sleep(100);
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
  // A block standing in one of the field's water cells (a plank a route bridged the empty channel with) is dug even with
  // the channel's water beside it: the water it lets in is the water the cell is planned to hold.
  return performDig(bot, pos, block, TAG, { waterCell: normalizeBlockName(step.wanted || '') === WATER });
}

async function placeOne(bot, step, ev) {
  const pos = ev.pos;
  // A water cell already holding a source is placed: a channel's sources make a source of a cell between two of them.
  // A cell the water only ran into is poured (blueprint_survey reads it missing).
  if (normalizeBlockName(step.type) === WATER && require('@utils/gravity_utils').isWaterSource(bot, pos.x, pos.y, pos.z)) return 'already';
  const itemName = resolveItemName(bot, step.type);
  if (!itemName) return false;

  // A water cell is never footing: a body standing in it (a fallback stand while the pouring anchor's own
  // ground is unlaid) would pillar a block into the cell instead. Refused here; the pour waits for a visit
  // that stands beside it.
  if (normalizeBlockName(step.type) === WATER && ev.underFeet) {
    watcher.warn(TAG, `Pour deferred at (${pos.x},${pos.y},${pos.z}) — the body stands in the water cell; it pours from beside it.`);
    return false;
  }

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
    if (!await performDig(bot, pos, current, TAG, { waterCell: normalizeBlockName(step.type) === WATER })) return false;
  }

  if (normalizeBlockName(step.type) === WATER) return pourWater(bot, pos);

  // Equip/aim/click/re-sense live in the shared place route (Law 16); `ok` is the whole verdict here.
  const placed = await performPlace(bot, pos, ev.anchor, ev.face, itemName, TAG);
  if (placed.ok) return true;
  watcher.warn(TAG, `Place failed at (${pos.x},${pos.y},${pos.z}) — ${placed.reason}`);
  return false;
}

// pourWater(bot, pos) — empties the pocket's water bucket into the open cell at pos, aiming at the top of the
// block under it. The blueprint stands its pouring anchor beside the cell so the look reaches that floor
// through the open cell and over nothing else; a look that grazed a crop cell would pour onto it instead.
// The cell over the water is the anchor's own air, opened here before the look: on ground a block higher than
// the field it is still a solid block, and a look at the floor would end on that block and pour on top of it.
// The bucket is emptied only when the look ends on a face that opens into the cell: the floor's top face, or, where a
// one-wide channel's bank hides the floor from the stand, the side face of a bank block that faces the cell. Any other
// block the look ends on is refused.
// THE SERVER'S BUCKET STOPS AT AN OUTLINE. The client's cursor passes through a block with no collision box (sugar cane,
// grass), but the server's bucket ray stops on its outline and pours on the face it meets: on top of the cane, or into
// the crop row beside it. So a look is refused when any cell it crosses before its aim holds a block other than air or
// water (`_lookCrosses`). A block with no collision box in the way (cane beside the channel, leaf litter, a tuft) is
// dug and the look is tried again: cane taken from beside an unpoured channel cell is the field's own crop, planted
// again by the plant pass once the water stands, and a channel cell no stand can reach past its cane never fills.
// NATURAL GROUND IN THE LOOK IS DUG THE SAME WAY. A field cut into a slope stands its pouring anchor under the bank it was
// cut from, and that bank's ground at head height ends every look short of the cell. The bank is no structure's, so a
// natural block (group natural_block) the look ends on, that no structure holds (blueprint_survey and mining_integrity
// protected cells), is dug and the look tried again, within the same CLEAR_IN_LOOK. Otherwise the cell is refused on every
// visit and the field never fills.
const FACE_UP = 1;
const RAY_STEP = 0.05;
const CLEAR_IN_LOOK = 4;   // blocks with no collision box one pour may dig out of its looks
function _lookCrosses(bot, eye, aim, target, cell) {
  const d = aim.minus(eye), len = d.norm();
  for (let t = 0; t < len; t += RAY_STEP) {
    const p = eye.plus(d.scaled(t / len)).floored();
    if (p.equals(target) || p.equals(cell)) continue;
    const b = bot.blockAt(p);
    if (b && !isAir(b.name) && !isFluid(b.name)) return b;
  }
  return null;
}
// _unheldGround(bot, block) — is this a natural block no structure holds, which a pour may dig out of its look?
const NATURAL = new Set(group_to_item.natural_block || []);
function _unheldGround(bot, block) {
  if (!block || !NATURAL.has(block.name)) return false;
  const k = `${block.position.x},${block.position.y},${block.position.z}`;
  const held = [blueprintSurvey.getAllProtectedBlocks(bot), require('@perception/mining_integrity').getProtectedBlocks(bot)];
  return !held.some(set => set && set.has(k));
}
// [dx, dz, face] — a bank block beside the cell and its face (mineflayer numbering) that opens into the cell.
const BANK_FACES = [[0, 1, 2], [0, -1, 3], [1, 0, 4], [-1, 0, 5]];
async function pourWater(bot, pos) {
  const bucket = bot.inventory.items().find(i => i.name === 'water_bucket');
  if (!bucket) return false;
  const floor = bot.blockAt(pos.offset(0, -1, 0));
  if (!floor || isAir(floor.name) || isFluid(floor.name)) {
    watcher.warn(TAG, `Pour refused at (${pos.x},${pos.y},${pos.z}) — no solid floor under the water cell (found ${floor ? floor.name : 'unloaded'}).`);
    return false;
  }
  const over = pos.offset(0, 1, 0);
  const overBlock = bot.blockAt(over);
  if (overBlock && !isAir(overBlock.name) && !(await performDig(bot, over, overBlock, TAG))) {
    watcher.warn(TAG, `Pour refused at (${pos.x},${pos.y},${pos.z}) — the cell over it holds ${overBlock.name}, which did not break.`);
    return false;
  }
  const aims = [{ block: floor.position, face: FACE_UP, at: new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5) }];
  for (const [dx, dz, face] of BANK_FACES) {
    const bank = bot.blockAt(pos.offset(dx, 0, dz));
    if (!bank || isAir(bank.name) || isFluid(bank.name)) continue;
    aims.push({ block: bank.position, face, at: new Vec3(pos.x + 0.5 + dx * 0.5, pos.y + 0.5, pos.z + 0.5 + dz * 0.5) });
  }
  let hit = null;
  let opens = false;
  for (let i = 0, cleared = 0; i < aims.length; i++) {
    const aim = aims[i];
    const aimed = await guardExternal(TAG, `equip/lookAt at (${pos.x},${pos.y},${pos.z})`, async () => {
      await bot.equip(bucket, 'hand');
      await bot.lookAt(aim.at, true);
      return bot.blockAtCursor(BLOCK_REACH);
    });
    hit = aimed.ok ? aimed.value : null;
    opens = !!hit && hit.position.equals(aim.block) && hit.face === aim.face;
    if (hit && !opens && !hit.position.equals(aim.block) && !hit.position.equals(pos) && cleared < CLEAR_IN_LOOK
      && _unheldGround(bot, hit) && await performDig(bot, hit.position, hit, TAG)) {
      cleared++;
      i--;   // the same aim again, past the ground just dug
      continue;
    }
    const crossed = opens ? _lookCrosses(bot, bot.entity.position.offset(0, bot.entity.eyeHeight, 0), aim.at, aim.block, pos) : null;
    if (crossed && crossed.boundingBox === 'empty' && cleared < CLEAR_IN_LOOK && await performDig(bot, crossed.position, crossed, TAG)) {
      cleared++;
      i--;   // the same aim again, past the block just dug
      continue;
    }
    if (crossed) {
      opens = false;
      hit = { name: `${crossed.name} crossed before it`, position: crossed.position, face: aim.face };
    }
    if (opens) break;
  }
  if (!opens) {
    const at = hit ? `${hit.name} at (${hit.position.x},${hit.position.y},${hit.position.z}) face ${hit.face}` : 'nothing in reach';
    watcher.warn(TAG, `Pour refused at (${pos.x},${pos.y},${pos.z}) — the look ends on ${at}, not a face that opens into the cell (${aims.length} aim(s) tried).`);
    return false;
  }
  await guardExternal(TAG, `pour at (${pos.x},${pos.y},${pos.z})`, async () => bot.activateItem());
  await sleep(300);
  if (bot.blockAt(pos)?.name === WATER) {
    const level = require('@utils/gravity_utils').waterLevel(bot, pos.x, pos.y, pos.z);
    watcher.summary(TAG, `POURED at (${pos.x},${pos.y},${pos.z}) level=${level ?? '-'} source=${level === 0 ? 1 : 0}.`);
    return true;
  }
  watcher.warn(TAG, `Pour at (${pos.x},${pos.y},${pos.z}) left ${bot.blockAt(pos)?.name || 'unloaded'} there, not water.`);
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
async function buildAnchor(bot, stand, steps, anchorLabel, relocated) {
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
  return anchoredRepair.repairAtAnchor(bot, { stand, steps, label: anchorLabel, relocated }, ops);
}

// tendPlot(bot, roomKey, blueprintName) → services ONE plot: builds its structure, then till/plant/
// harvest the cells it reaches, and returns the outcome. Law 15 sub-loop API — farm_manager calls this
// directly and owns the routing to recursive_judge; a per-plot failure returns worked=0 with a reason.
//
// ── BONE MEAL ── applied where the bot is already standing over its own crops, no separate trip. ONE CROP AT A
// TIME, UNTIL IT IS RIPE: the field's first wheat is what the crew waits on, so the pocket's bone meal ripens crops
// whole rather than nudging every crop a stage. A plant past BONE_MEAL_MAX_CROP_STAGE is skipped (already due for
// harvest); a use that did not advance the plant ends that plant (activateBlock cannot fail loudly — Law 25). Reads the crop census,
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
  // Most-grown first: the crop nearest ripe takes the fewest to finish.
  const cells = bonemealTargets(bot, stand, roomKey)
    .map(c => ({ c, age: getWheatAge(bot.blockAt(new Vec3(c.x, c.y + 1, c.z))) }))
    .sort((a, b) => b.age - a.age).map(t => t.c);
  for (const cell of cells) {
    const cropPos = new Vec3(cell.x, cell.y + 1, cell.z);
    for (;;) {
      const item = held();
      if (!item) return;
      const age = getWheatAge(bot.blockAt(cropPos));
      if (age == null || age > BONE_MEAL_MAX_CROP_STAGE) break;
      await require('@kernel/item_book').during('bone_meal', 'planted', async () => {
        await bot.equip(item, 'hand');
        await bot.activateBlock(bot.blockAt(cropPos));
      });
      await sleep(BONE_MEAL_SETTLE_MS);
      const after = getWheatAge(bot.blockAt(cropPos));
      if (after == null || after <= age) break;
      ctx.bonemealed = (ctx.bonemealed || 0) + 1;
    }
  }
}

async function tendPlot(bot, roomKey, blueprintName, walkedIn = false) {
    if (!bot?.entity?.position) {
      throw new Error(`[${TAG}] CODING VIOLATION: global.bot is not set before tendPlot ran.`);
    }
    // Geometry is read from this instance's lock, never named from config, so it can't go stale against
    // what set_buildspot actually stamped (Law 25).
    if (typeof roomKey !== 'string' || !roomKey) {
      throw new Error(`[${TAG}] CODING VIOLATION (Law 13): tendPlot needs the field's room key, got ${JSON.stringify(roomKey)}.`);
    }
    blueprintName = blueprintName || blueprintSurvey.geometryOf(roomKey);

    // The field's anchors (stand = anchor floor Y+1); a blueprint may declare several when the field
    // exceeds one stand's reach. getWorldAnchors throws if the site isn't locked (Law 13).
    const worldAnchors = blueprintSurvey.getWorldAnchors(blueprintName, roomKey);
    // Resolve each anchor to a standable stand — its own feet if intact, else a dry lip within reach
    // (Law 16). null ⇒ nothing standable reaches this plot; guarded here too (Law 13).
    const fallback = blueprintRegistry.getBuilding(blueprintName, TAG).stand_fallback !== false;
    const footprint = blueprintSurvey.getFootprintCells(blueprintName, roomKey) || new Set();
    // A FIELD THIS BODY CANNOT SEE IS ASKED OF THE KEEPER: a body claiming the visit from far off (a cocoa search 300 b
    // out) reads no floor at any anchor, so its own look would call every anchor stranded. The keeper's fields verdict
    // holds each anchor's stand by this same rule, and those stands are walked to. A crew with no keeper looks itself.
    const outOfSight = worldAnchors.some(a => !bot.blockAt(new Vec3(a.x, a.y, a.z)));
    const kept = outOfSight ? require('@kernel/keeper_verdicts').keptEntry('fields', roomKey) : null;
    if (kept) watcher.summary(TAG, `field ${roomKey} out of sight: stands from the keeper, ${kept.stands.filter(Boolean).length}/${worldAnchors.length} standable`);
    // THE BODY WALKS IN BEFORE IT LOOKS: the field's cells (getFarmlandCells, getFieldPlan) are read from the body's own
    // world, so from far off every stand reached no cell and the visit walked nowhere and worked nothing, five times,
    // until recursive_judge killed it. The body walks to the keeper's first stand and the visit begins again from there,
    // once (walkedIn).
    if (kept && !walkedIn) {
      const first = kept.stands.find(Boolean);
      if (first) {
        if (!await reachStand(bot, first.floor)) {
          watcher.warn(TAG, `${TAG}: fail out-of-sight field ${roomKey}: the keeper's stand (${first.feet.x},${first.feet.y},${first.feet.z}) was not reached`);
          return { worked: 0, refused: 0, reason: 'anchor_unreachable', metrics: {} };
        }
        return tendPlot(bot, roomKey, blueprintName, true);
      }
    }
    const resolved = kept ? kept.stands : worldAnchors.map(a => anchoredRepair.resolveStandableAnchor(bot, a, { fallback, footprint }));
    if (resolved.every(r => r === null)) {
      watcher.warn(TAG, `all ${worldAnchors.length} anchor(s) stranded — no standable stand reaches the plot (dynamic water?); non-actionable this pass.`);
      return { worked: 0, refused: 0, reason: 'stranded', metrics: {} };
    }
    const resolvedFloor = resolved.map((r, i) => r ? { ...r.floor } : { x: worldAnchors[i].x, y: worldAnchors[i].y, z: worldAnchors[i].z });
    const stands = resolved.map((r, i) => r ? r.feet : ({ x: worldAnchors[i].x, y: worldAnchors[i].y + 1, z: worldAnchors[i].z }));
    const usingAlt = resolved.some(r => r && r.alternate);
    if (usingAlt) watcher.summary(TAG, `stand relocated: ${resolved.filter(r => r && r.alternate).length}/${worldAnchors.length} anchor(s) tended from a nearby floor (primary stand not standable).`);

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

    // ── CONSTRUCTION, THEN THE POUR, THEN THE CROP ── The field is a blueprint and is built by its rules: every block
    // first (the natural floor under each water cell, the rows, the walkways), at each anchor in turn. The water is the
    // last piece of the blueprint and is poured only once every other block is correct, so it stands in a channel one
    // deep. Tilling and planting come after the water is in. A field whose pour cannot happen
    // (farming_integrity.waterOutOfReach) is tended dry; one still being built is harvested only.
    const struct = { dig_ok: 0, place_ok: 0, place_fail: 0, deferred: 0 };
    const ctx = { cleared: 0, tilled: 0, planted: 0, harvested: 0, drops: 0,
                  clearRefused: 0, tillRefused: 0, plantRefused: 0, awaitingWater: 0, tillDeferred: 0,
                  awaitingBuild: 0,
                  tillBudget: 0,   // re-armed per stand from live seed count (see tillBudget)
                  missingHoe: false, missingSeeds: false };
    const isWater = (s) => s.action === 'place' && normalizeBlockName(s.type) === WATER;
    const byAnchor = (steps) => {
      const out = worldAnchors.map(() => []);
      for (const s of steps) {
        const ai = s.anchor_index ?? -1;
        if (ai >= 0 && ai < worldAnchors.length) out[ai].push(s);
      }
      return out;
    };
    const buildPass = async (perAnchor, label) => {
      for (let i = 0; i < stands.length; i++) {
        if (perAnchor[i].length === 0) continue;
        if (!await reachStand(bot, resolvedFloor[i])) {
          watcher.warn(TAG, `${TAG}: fail anchor ${i} unreachable (${stands[i].x},${stands[i].y},${stands[i].z})`);
          return false;
        }
        const r = await buildAnchor(bot, stands[i], perAnchor[i], `farm anchor ${i} ${label}`, !!(resolved[i] && resolved[i].alternate));
        struct.dig_ok += r.dig_ok || 0; struct.place_ok += r.place_ok || 0;
        struct.place_fail += r.place_fail || 0; struct.deferred += r.deferred || 0;
      }
      return true;
    };
    const pending = async () => {
      const s = await blueprintSurvey.survey(bot, blueprintName, roomKey);
      return Array.isArray(s?.steps) ? s.steps : [];
    };

    // (1) CONSTRUCTION — every step but the water. Abandon to the judge on an unreachable anchor (Law 13).
    if (!await buildPass(anchorSteps.map(steps => steps.filter(s => !isWater(s))), 'build')) {
      return { worked: 0, refused: 0, reason: 'anchor_unreachable', metrics: {} };
    }
    // (2) THE POUR — read again: only a field whose every other block is correct takes its water.
    let left = await pending();
    const unbuilt = left.filter(s => !isWater(s)).length;
    if (unbuilt === 0 && left.some(isWater)) {
      if (!await buildPass(byAnchor(left.filter(isWater)), 'pour')) {
        return { worked: 0, refused: 0, reason: 'anchor_unreachable', metrics: {} };
      }
      left = await pending();
    } else if (unbuilt > 0 && left.some(isWater)) {
      watcher.summary(TAG, `${roomKey}: the pour waits — ${unbuilt} block(s) of the field are not built yet.`);
    }
    // (3) THE CROP — tilled and planted once the blueprint stands whole, its water included (or the water is out of
    // reach); otherwise only harvested.
    const built = left.length === 0
      || (left.every(isWater) && require('@perception/farming_integrity').waterOutOfReach());

    for (let i = 0; i < stands.length; i++) {
      const stand = stands[i];
      // FIELD at this spot — harvest/clear → collect → till → plant → collect → plant, each an ordered restricted pass
      // (Invariant B). The closing collect+replant catches seed drops that scattered out of range on the first
      // collect; the guard below also checks bonemealTargets since a bonemeal-only visit has an empty corrective plan.
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
      if (built) {
        // Re-armed per stand from the live seed count against what's already waiting to be sown.
        ctx.tillBudget = tillBudget(bot, getFieldPlan(bot, roomKey).filter(p => reaches(bot, stand, p)));
        await applyReachable(TILL_ONLY);        // hoe at most as much dirt as there is seed to fill
        await applyReachable(PLANT_ONLY);       // sow it the same visit
        await collectHere();                    // one more drop collect — catch a missed/scattered seed
        await applyReachable(PLANT_ONLY);       // one last replant attempt, then move on
      } else {
        ctx.awaitingBuild += getFieldPlan(bot, roomKey)
          .filter(p => reaches(bot, stand, p) && p.actions.some(a => TILL_ONLY.has(a) || PLANT_ONLY.has(a))).length;
      }
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
      + (ctx.plantRefused ? ` [plant refused x${ctx.plantRefused}]` : '')
      + (ctx.awaitingWater ? ` [awaiting water x${ctx.awaitingWater}]` : '')
      + (ctx.awaitingBuild ? ` [awaiting the built field x${ctx.awaitingBuild}]` : '');
    watcher.summary(TAG, readable);

    // Returns to the manager (Law 16): worked>0 is progress; worked===0 && refused>0 is a stuck plot,
    // never counted as success. Missing hoe/seeds stays actionable to re-post (Law 13).
    return { worked, refused, metrics, missingHoe: ctx.missingHoe, missingSeeds: ctx.missingSeeds,
             reason: (worked === 0 && refused > 0) ? 'field_refused' : 'farm_pass' };
}

module.exports = { tendPlot, pourWater };
